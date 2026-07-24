export const MAX_HNSW_VECTOR_DIMENSIONS = 2000;
export const OPENAI_TEXT_EMBEDDING_3_LARGE_DIMENSIONS = 1536;

export function invalidEmbeddingDimensionsMessage(dimensions: number): string {
  return `Embedding dimensions cannot exceed ${MAX_HNSW_VECTOR_DIMENSIONS}. pgvector HNSW indexes support at most ${MAX_HNSW_VECTOR_DIMENSIONS} dimensions. For OpenAI text-embedding-3-large, use ${OPENAI_TEXT_EMBEDDING_3_LARGE_DIMENSIONS}. Got: ${dimensions}.`;
}

export function validateEmbeddingDimensions(dimensions: number | undefined): string | undefined {
  if (dimensions === undefined) return undefined;
  if (typeof dimensions !== "number" || !Number.isFinite(dimensions) || dimensions < 1) {
    return "Embedding dimensions must be positive";
  }
  if (dimensions > MAX_HNSW_VECTOR_DIMENSIONS) {
    return invalidEmbeddingDimensionsMessage(dimensions);
  }
  return undefined;
}

export function assertValidEmbeddingDimensions(dimensions: number): void {
  const error = validateEmbeddingDimensions(dimensions);
  if (error) throw new Error(error);
}
