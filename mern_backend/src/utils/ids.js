import crypto from 'node:crypto';

// Every primary key in the schema is `VARCHAR(64)` with no DEFAULT, so ids are
// minted here and passed explicitly on INSERT. Prefixes make ids self-describing
// in logs and in the deployment pipeline; 4 + 32 chars stays inside VARCHAR(64).
export function newId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
}

export const ID = {
  user: () => newId('usr'),
  connection: () => newId('con'),
  project: () => newId('prj'),
  service: () => newId('svc'),
  deployment: () => newId('dep'),
  envVar: () => newId('env'),
};
