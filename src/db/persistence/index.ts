export { CollectionPersistenceService } from "./service.js";
export { CollectionPersistenceRepository } from "./repository.js";
export { CollectionTaskRepository } from "./task-repository.js";
export { PersistenceError, persistenceErrorType, safePersistenceSummary } from "./errors.js";
export { mapProbeComment, mapProbePost, validatePersistPostInput } from "./mapping.js";
export { RAW_REDACTION_VERSION, serializeSanitizedPayload } from "./redaction.js";
export type {
  BrandMatchInput,
  CollectionTaskStatus,
  CollectionTriggerType,
  CreateTaskInput,
  MappedComment,
  MappedPost,
  PersistBatchInput,
  PersistBatchResult,
  PersistCommentInput,
  PersistPostInput,
  PersistenceErrorType
} from "./types.js";
