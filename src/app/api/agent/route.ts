import { agentInput, BackendError, runAgent } from "@/lib/agents";

export const runtime = "nodejs";
export async function POST(request: Request) {
  const host = request.headers.get("host") || "";
  const origin = request.headers.get("origin");
  if (
    !/^(localhost|127\.0\.0\.1):3000$/.test(host) ||
    (origin &&
      !["http://localhost:3000", "http://127.0.0.1:3000"].includes(origin))
  )
    return Response.json(
      { detail: "Use the local Talk2Data app to access this workspace." },
      { status: 403 },
    );
  const parsed = agentInput.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return Response.json(
      { detail: "Check the source, question and answers." },
      { status: 422 },
    );
  try {
    return Response.json(
      await runAgent(parsed.data, { signal: request.signal }),
    );
  } catch (error) {
    return Response.json(
      {
        detail:
          error instanceof BackendError
            ? error.message
            : "The agent could not complete this request. Check your model connection and source, then try again.",
      },
      { status: error instanceof BackendError ? error.status : 502 },
    );
  }
}
