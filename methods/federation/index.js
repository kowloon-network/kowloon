// /methods/federation/index.js

import shouldFederate from "./shouldFederate.js";
import verifyHttpSignature from "./verifyHttpSignature.js";
import resolveAudience from "./resolveAudience.js";
import enqueueOutbox from "./enqueueOutbox.js";
import signHttpRequest from "./signHttpRequest.js";
import {
  processOutboxBatch,
  startOutboxWorker,
} from "./outboxWorker.js";
import pullFromRemote from "./pullFromRemote.js";
import fetchRemoteServerProfile from "./fetchRemoteServerProfile.js";
import normalizeInboundActivity from "./normalizeInboundActivity.js";
import { processPollBatch, startPollWorker } from "./pollWorker.js";

// Default export used by Kowloon.federation
const federation = {
  shouldFederate,
  verifyHttpSignature,
  pullFromRemote,
  fetchRemoteServerProfile,
  resolveAudience,
  enqueueOutbox,
  signHttpRequest,
  processOutboxBatch,
  startOutboxWorker,
  normalizeInboundActivity,
  processPollBatch,
  startPollWorker,
};

export default federation;

export {
  shouldFederate,
  verifyHttpSignature,
  pullFromRemote,
  fetchRemoteServerProfile,
  resolveAudience,
  enqueueOutbox,
  signHttpRequest,
  processOutboxBatch,
  startOutboxWorker,
  normalizeInboundActivity,
  processPollBatch,
  startPollWorker,
};
