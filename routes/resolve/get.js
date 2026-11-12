// routes/resolve/get.js
// Resolve object by ID for remote servers
import route from "../utils/route.js";
import getObjectById from "#methods/core/getObjectById.js";
import sanitizeObject from "#methods/sanitize/object.js";
import { getViewerContext } from "#methods/visibility/context.js";
import { canSeeObject } from "#methods/visibility/helpers.js";
import Kowloon from "#kowloon";
import { isPersonBlocked } from "#methods/moderation/federationPolicy.js";

export default route(async ({ req, query, set, setStatus }) => {
  const { id, actorId } = query;

  if (!id) {
    setStatus(400);
    set("error", "Missing 'id' query parameter");
    return;
  }

  try {
    let viewerId = req.user?.id || null;

    // If actorId is provided, verify HTTP signature to authenticate the remote actor
    if (actorId && !viewerId) {
      const sig = await Kowloon.federation.verifyHttpSignature(req, {
        actorId,
        verifyReplay: false, // Don't verify replay for GET requests
      });

      if (sig.ok) {
        // A person on our Blocked list reads nothing beyond what's public
        // to anyone (methods/moderation/federationPolicy.js).
        if (await isPersonBlocked(actorId)) {
          setStatus(403);
          set("error", "You are blocked on this server");
          return;
        }
        // HTTP signature verified - use the actorId as viewerId
        viewerId = actorId;
      } else if (sig.status === 403) {
        setStatus(403);
        set("error", sig.error);
        return;
      } else {
        // Signature verification failed - log but continue as anonymous
        console.warn("RESOLVE: HTTP signature verification failed for actorId:", actorId, sig.error);
      }
    }

    // Get object with local-only mode
    const result = await getObjectById(id, {
      viewerId,
      mode: "local", // Only return local objects
      enforceLocalVisibility: false, // We'll check visibility ourselves
      hydrateRemoteIntoDB: false, // Don't fetch remote objects
    });

    if (!result || !result.object) {
      setStatus(404);
      set("error", "Object not found");
      return;
    }

    // Actors (User/Person/Group/etc.) are always publicly resolvable for federation
    const objectType = result.object.type || result.object.objectType || "";
    const isActor = /^(User|Person|Group|Service|Application|Organization)$/i.test(objectType);

    if (!isActor) {
      // Check visibility permissions for non-actor objects
      const ctx = await getViewerContext(viewerId);
      const canView = await canSeeObject(result.object, ctx);

      if (!canView) {
        setStatus(404); // Return 404 instead of 403 to avoid leaking existence
        set("error", "Object not found");
        return;
      }
    }

    // Sanitize the object to remove sensitive fields
    const sanitized = sanitizeObject(result.object, {
      objectType: result.object.objectType || result.object.type,
    });

    // Return the sanitized object
    setStatus(200);
    set("item", sanitized);
  } catch (error) {
    console.error("RESOLVE: Error resolving object:", error);
    setStatus(500);
    set("error", error.message || "Internal server error");
  }
});
