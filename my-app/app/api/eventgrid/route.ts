import { NextResponse } from "next/server";

// (Opcional) token simples via querystring ?token=...
function checkToken(req: Request) {
  const { searchParams } = new URL(req.url);
  const token = searchParams.get("token");
  const expected = process.env.EVENTGRID_WEBHOOK_TOKEN;
  return !expected || token === expected;
}

export async function OPTIONS(req: Request) {
  // Necessário quando o schema de saída é CloudEvents:
  // Event Grid usa OPTIONS como "abuse protection" / validação. :contentReference[oaicite:1]{index=1}
  return new NextResponse(null, { status: 200 });
}

export async function POST(req: Request) {
  if (!checkToken(req)) return new NextResponse("unauthorized", { status: 401 });

  const body = await req.json();
  const events = Array.isArray(body) ? body : [body];

  // Validação do Event Grid (Event Grid event schema):
  // Ele manda SubscriptionValidationEvent e você devolve { validationResponse: <code> }. :contentReference[oaicite:2]{index=2}
  const validationEvent = events.find(
    (e: any) =>
      e?.eventType === "Microsoft.EventGrid.SubscriptionValidationEvent" ||
      e?.type === "Microsoft.EventGrid.SubscriptionValidationEvent"
  );

  if (validationEvent) {
    const code = validationEvent?.data?.validationCode;
    return NextResponse.json({ validationResponse: code });
  }

  // Eventos reais
  console.log("EventGrid payload:", events);

  // Responda rápido com 200 (Event Grid faz retry se falhar/demorar). :contentReference[oaicite:3]{index=3}
  return new NextResponse("ok", { status: 200 });
}
