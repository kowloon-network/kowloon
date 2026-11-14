// GET /auth/me — return fresh profile + prefs for the authenticated user
import route from '../utils/route.js';
import { User } from '#schema';
import isServerAdmin from '#methods/auth/isServerAdmin.js';
import { isServerModerator } from '#methods/auth/staffPolicy.js';

export default route(async ({ user, set, setStatus }) => {
  const userDoc = await User.findOne({ id: user.id })
    .select('id username type profile prefs publicKey circles email emailVerified')
    .lean();

  if (!userDoc) {
    setStatus(404);
    set('error', 'User not found');
    return;
  }

  set('user', {
    id: userDoc.id,
    username: userDoc.username,
    type: userDoc.type,
    profile: userDoc.profile,
    prefs: userDoc.prefs,
    publicKey: userDoc.publicKey,
    following: userDoc.circles?.following,
    allFollowing: userDoc.circles?.allFollowing,
    blocked: userDoc.circles?.blocked,
    muted: userDoc.circles?.muted,
    groups: userDoc.circles?.groups,
    isServerAdmin: !!(await isServerAdmin(userDoc.id)),
    isServerMod: !!(await isServerModerator(userDoc.id)),
    // Your own email, for Settings. Never to a visiting (cross-server
    // OAuth) session: that's another server asking, not you.
    ...(user.scope === 'visiting' ? {} : { email: userDoc.email || null, emailVerified: !!userDoc.emailVerified }),
  });
}, { allowUnauth: false });
