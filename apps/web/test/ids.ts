import { uuidv7 } from "@retail/core";

/** A fresh UUIDv7, for accounts and other made-up ids in tests. */
export const newUuid = (): string => uuidv7();
