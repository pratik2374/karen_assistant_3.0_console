export enum SchemaVersion {
  V1 = 1,
  V2 = 2
}

export const CurrentSchemaVersion = SchemaVersion.V1;

export interface VersionedEntity {
  schemaVersion: SchemaVersion;
}
