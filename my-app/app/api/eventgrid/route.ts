// app/api/eventgrid/route.ts
import { NextResponse } from "next/server";

/**
 * Event Grid -> Webhook (Vercel / Next.js App Router)
 *
 * Suporta:
 * 1) Validação via OPTIONS (CloudEvents schema): responde headers WebHook-Allowed-Origin/Rate
 * 2) Validação via SubscriptionValidationEvent (EventGrid schema): responde { validationResponse }
 * 3) Eventos MQTT do Event Grid:
 *    - System events (ex: MQTTClientSessionDisconnected)
 *    - MQTT Routed Messages (CloudEvents) com type === "MQTT.EventPublished"
 *      - decodifica data_base64 quando existir
 *
 * Segurança:
 * - Token simples por querystring ?token=... (opcional)
 */

// GARANTE Buffer (Node runtime). Em Edge runtime Buffer pode não existir.
export const runtime = "nodejs";

function checkToken(req: Request) {
  const { searchParams } = new URL(req.url);
  const token = searchParams.get("token");
  const expected = process.env.EVENTGRID_WEBHOOK_TOKEN;
  return !expected || token === expected;
}

function safeJsonStringify(obj: any) {
  try {
    return JSON.stringify(obj);
  } catch {
    return String(obj);
  }
}

function tryDecodeBase64ToUtf8(b64: unknown): string | null {
  try {
    if (typeof b64 === "string") {
      return Buffer.from(b64, "base64").toString("utf-8");
    }

    // Alguns casos raros podem chegar como objeto/array (dependendo do middleware)
    if (b64 && typeof b64 === "object") {
      const joined = Array.isArray(b64)
        ? b64.join("")
        : Object.values(b64 as Record<string, any>).join("");
      return Buffer.from(joined, "base64").toString("utf-8");
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * CloudEvents schema (Event Grid) faz uma validação com OPTIONS:
 * - Envia header WebHook-Request-Origin
 * - Espera de volta WebHook-Allowed-Origin e WebHook-Allowed-Rate
 */
export async function OPTIONS(req: Request) {
  // Event Grid envia esse header quando está validando o endpoint
  const requestOrigin = req.headers.get("WebHook-Request-Origin");

  // Você pode ser mais restritivo (ex: validar domínios permitidos)
  const allowedOrigin = requestOrigin || "*";

  return new NextResponse(null, {
    status: 200,
    headers: {
      Allow: "POST, OPTIONS",
      "WebHook-Allowed-Origin": allowedOrigin, // ou "*"
      "WebHook-Allowed-Rate": "120", // req/min (ajuste conforme necessidade)
    },
  });
}

export async function POST(req: Request) {
  // Token simples (opcional)
  if (!checkToken(req)) return new NextResponse("unauthorized", { status: 401 });

  let body: any;
  try {
    body = await req.json();
  } catch (err: any) {
    console.error("Invalid JSON body:", err?.message || err);
    return new NextResponse("invalid json", { status: 400 });
  }

  const events = Array.isArray(body) ? body : [body];

  /**
   * 1) Validação (EventGrid schema): SubscriptionValidationEvent
   * (Algumas configurações/integrações ainda enviam isso)
   */
  const validationEvent = events.find(
    (e: any) =>
      e?.eventType === "Microsoft.EventGrid.SubscriptionValidationEvent" ||
      e?.type === "Microsoft.EventGrid.SubscriptionValidationEvent"
  );

  if (validationEvent) {
    const code = validationEvent?.data?.validationCode;
    console.log("SubscriptionValidationEvent received. Code:", code);
    return NextResponse.json({ validationResponse: code });
  }

  /**
   * 2) Processa eventos reais
   */
  for (const ev of events) {
    // CloudEvents (MQTT roteado) geralmente vem com fields: id, source, type, subject, time, specversion, datacontenttype, data_base64|data
    const evType = ev?.type || ev?.eventType; // CloudEvents: type / EventGrid: eventType
    const subject = ev?.subject;

    // 2.1) Mensagem MQTT roteada (CloudEvents)
    if (ev?.type === "MQTT.EventPublished") {
      const b64 = ev?.data_base64;
      const decoded = tryDecodeBase64ToUtf8(b64);

      // Se não veio base64, pode vir em data (por exemplo, payload JSON)
      if (decoded !== null) {
        console.log("MQTT.EventPublished (decoded)", {
          topic: subject,
          payload: decoded,
        });
      } else {
        console.log("MQTT.EventPublished (raw data)", {
          topic: subject,
          data: ev?.data,
        });
      }

      continue;
    }

    // 2.2) System events do broker (ex: desconexão, conexão etc.)
    // Exemplo: Microsoft.EventGrid.MQTTClientSessionDisconnected
    // Aqui é útil logar os campos mais importantes para diagnóstico.
    if (typeof evType === "string" && evType.includes("MQTT")) {
      console.log("MQTT system event", {
        eventType: evType,
        subject,
        data: ev?.data,
        time: ev?.eventTime || ev?.time,
      });
      continue;
    }

    // 2.3) Qualquer outro evento
    console.log("EventGrid event", {
      eventType: evType,
      subject,
      time: ev?.eventTime || ev?.time,
      payload: safeJsonStringify(ev),
    });
  }

  // Responda rápido com 200 para evitar retry
  return new NextResponse("ok", { status: 200 });
}
