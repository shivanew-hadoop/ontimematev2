export const config = { runtime: "edge" };

export default async function handler() {
  const client_ws_url = process.env.OPENAI_REALTIME_WSS;
  const client_secret = process.env.OPENAI_API_KEY;

  return new Response(JSON.stringify({
    client_ws_url,
    client_secret
  }), { status: 200 });
}
