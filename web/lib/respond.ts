// How the app's read endpoints answer: never cached, since every read is live (R15.6), and a
// failed read says only which read failed; the details go to the server's log.
export async function respond(what: string, read: () => Promise<unknown>): Promise<Response> {
  const headers = { "cache-control": "no-store" };
  try {
    return Response.json(await read(), { headers });
  } catch (e) {
    console.error(`${what}:`, e);
    return Response.json({ error: `couldn't read ${what}` }, { status: 502, headers });
  }
}
