import {
  IdempotencyConflict,
  InvalidPayload,
  receiveTransmitEnvelope,
  type SolidObjectsRuntime,
  type TransmitEnvelope,
} from "solid-objects"

export async function handleInspectionSync({
  request,
  runtime,
  canWrite,
}: {
  request: Request
  runtime: SolidObjectsRuntime
  canWrite: (options: { request: Request; envelope: TransmitEnvelope }) => Promise<boolean>
}): Promise<Response> {
  const envelope = (await request.json()) as TransmitEnvelope
  if (!(await canWrite({ request, envelope }))) return new Response("Forbidden", { status: 403 })

  try {
    await receiveTransmitEnvelope({ runtime, envelope })
    return Response.json({})
  } catch (error) {
    if (error instanceof InvalidPayload || error instanceof IdempotencyConflict) {
      return new Response(null, { status: 422 })
    }
    throw error
  }
}
