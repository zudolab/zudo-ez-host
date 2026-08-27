export interface PublicationServingFlags {
  spaFallback: boolean;
  gated: boolean;
}

export type PublicationResolution = {
  projectId: string;
  artifactHash: string;
  servingFlags: PublicationServingFlags;
} | null;
