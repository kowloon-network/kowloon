// Invite redemption routes
// Public endpoints for validating and redeeming server invites

import express from "express";
import { Invite } from "#schema";

const router = express.Router();

/**
 * GET /invites/:code
 * Check if an invite code is valid
 * Returns invite details (without sensitive data) if valid
 *
 * Query params:
 * - email: Optional email to check if it can redeem (for individual invites)
 */
router.get("/:code", async (req, res) => {
  try {
    const { code } = req.params;
    const { email } = req.query;

    const invite = await Invite.findOne({
      code,
      active: true,
      deletedAt: null,
    });

    if (!invite) {
      return res.status(404).json({ error: "Invite not found" });
    }

    if (!invite.isValid) {
      // Determine why it's invalid
      let reason = "Invite is no longer valid";
      if (invite.expiresAt && new Date() > invite.expiresAt) {
        reason = "Invite has expired";
      } else if (invite.type === "individual" && invite.usedAt) {
        reason = "Invite has already been used";
      } else if (
        invite.type === "open" &&
        invite.maxRedemptions !== null &&
        invite.redemptionCount >= invite.maxRedemptions
      ) {
        reason = "Invite has reached its redemption limit";
      }
      return res.status(410).json({ error: reason, valid: false });
    }

    // Check if specific email can redeem (for individual invites)
    let canRedeem = { allowed: true };
    if (email) {
      canRedeem = invite.canRedeem(email);
    } else if (invite.type === "individual") {
      // Individual invite without email check - indicate email is required
      canRedeem = { allowed: false, reason: "Email required to verify eligibility" };
    }

    // Return public invite info
    return res.json({
      valid: true,
      canRedeem: canRedeem.allowed,
      reason: canRedeem.reason || null,
      invite: {
        type: invite.type,
        welcomeMessage: invite.welcomeMessage || null,
        expiresAt: invite.expiresAt || null,
        // For individual invites, hint at the expected email domain
        emailHint: invite.type === "individual" && invite.email
          ? `*****@${invite.email.split("@")[1]}`
          : null,
        // For open invites, show remaining slots if limited
        remainingRedemptions: invite.type === "open" && invite.maxRedemptions !== null
          ? invite.remainingRedemptions
          : null,
      },
    });
  } catch (err) {
    console.error("Failed to check invite:", err);
    return res.status(500).json({ error: "Failed to check invite" });
  }
});

// POST /invites/:code/redeem was removed: it was unauthenticated and took any
// userId, so anyone could burn invite slots or mark invites redeemed by
// arbitrary users. Registration (routes/register/index.js) redeems the invite
// itself after creating the account, and no client called this route.

export default router;
