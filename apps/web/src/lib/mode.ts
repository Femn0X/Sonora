/**
 * "local": the web app stores songs in the browser (IndexedDB) and needs no server (default).
 * "server": songs live in the Sonora API + Postgres (set NEXT_PUBLIC_SONORA_MODE=server).
 */
export const LOCAL_MODE = process.env.NEXT_PUBLIC_SONORA_MODE !== "server";
