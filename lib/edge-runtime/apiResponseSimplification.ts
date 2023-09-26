import { Json } from "../database.types";
import { isID, swapKeysValues } from "../utils";

export type IDStore = { [key: string]: string };

export function removeIDs(
  obj: Json | Json[],
  existingStore?: IDStore,
): {
  cleanedObject: Json | Json[];
  idStore: IDStore;
} {
  /**
   * Removes IDs (as defined by utils.isID) from an arbitrary JSON object.
   * Replace IDs with an ID in the form ID1, ID2, etc.
   * Returns the cleaned object and a lookup table (idStore) of the original IDs
   * to the new IDs.
   */
  const store: IDStore = existingStore ?? {};
  // Deepcopy to prevent mutating the original object
  const removedObj = JSON.parse(JSON.stringify(obj));
  let idIdx = 0;

  function findAndReplaceID(json: Json | Json[]) {
    if (!json || typeof json !== "object") return;

    // Creates the same iterator for both arrays and objects
    const entries = Array.isArray(json)
      ? json.entries()
      : Object.entries(json as { [key: string]: Json });

    for (const [key, value] of entries) {
      const k = key as string;
      if (typeof value === "object") {
        findAndReplaceID(value);
      } else if (typeof value === "string") {
        if (value.includes("/")) {
          // If string is a path, operate on individual segments
          const urlParts = value
            .split("/")
            .map((part) => (isID(part) ? getOrGenerateID(part) : part));
          (json as any)[k] = urlParts.join("/");
        } else if (isID(value)) {
          (json as any)[k] = getOrGenerateID(value);
        }
      }
    }
  }

  function getOrGenerateID(value: string): string {
    let id = store[value];
    if (!id) {
      id = `ID${++idIdx}`;
      store[value] = id;
    }
    return id;
  }

  findAndReplaceID(removedObj);
  return { cleanedObject: removedObj, idStore: store };
}

export function reAddIDs(obj: Json | Json[], idStore: IDStore): Json | Json[] {
  /**
   * Takes an object containing IDs in the form ID1, ID2 (as generated by removeIDs),
   * and an idStore returned by removeIDs.
   * Returns the object with the original IDs readded to it
   */

  // Deepcopy to prevent mutating the original object
  const objWithIDs = JSON.parse(JSON.stringify(obj));
  // Need a lookup table for the original IDs, which is the reverse of uuidStore
  idStore = swapKeysValues(idStore);

  function findAndReplaceID(json: any) {
    // Creates the same iterator for both arrays and objects
    const entries = Array.isArray(json) ? json.entries() : Object.entries(json);

    for (const [key, value] of entries) {
      if (typeof value === "string") {
        if (value.includes("/")) {
          // If string is a path, operate on individual segments
          const segments = value.split("/");
          for (let i = 0; i < segments.length; i++) {
            if (idStore[segments[i]]) {
              segments[i] = idStore[segments[i]];
            }
          }
          json[key] = segments.join("/");
        } else if (idStore[value]) {
          json[key] = idStore[value];
        }
      } else if (value && typeof value === "object") {
        findAndReplaceID(value);
      }
    }
  }

  findAndReplaceID(objWithIDs);
  return objWithIDs;
}
