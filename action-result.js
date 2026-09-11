const ACTION_RESULT_METADATA_FIELDS = ["meta", "errorCode", "errorMessage"];

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function getActionResultMetadata(result) {
  const metadata = {};
  if (!isRecord(result)) return metadata;

  for (const field of ACTION_RESULT_METADATA_FIELDS) {
    if (hasOwn(result, field)) metadata[field] = result[field];
  }
  return metadata;
}

function createActionResultEnvelope(message) {
  const source = isRecord(message) ? message : {};
  return {
    data: source.data,
    ...getActionResultMetadata(source)
  };
}

function normalizeActionResult(result) {
  if (!isRecord(result) || !hasOwn(result, "data")) return { data: result };
  return {
    data: result.data,
    ...getActionResultMetadata(result)
  };
}

function isHardActionResultFailure(result) {
  if (!isRecord(result)) return false;

  const hasFailure = ["errorCode", "errorMessage"].some((field) => {
    return hasOwn(result, field) && result[field] !== undefined && result[field] !== null && result[field] !== "";
  });
  if (!hasFailure) return false;

  return String(result.meta?.status || "").toLowerCase() !== "partial";
}

module.exports = {
  createActionResultEnvelope,
  getActionResultMetadata,
  isHardActionResultFailure,
  normalizeActionResult
};
