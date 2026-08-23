// Shared between actions.ts and page.tsx — a "use server" file may only
// export async functions, not plain values, so this constant has to live
// outside actions.ts even though it's only ever used alongside it.
export const NEW_KEY_REVEAL_COOKIE = "bl_new_api_key";
