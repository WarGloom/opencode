export function parse(value: string) {
  const [providerID, ...modelID] = value.split("/")
  return { providerID, modelID: modelID.join("/") }
}

export function display(
  value: { providerID: string; modelID: string },
  providers?: readonly { id: string; name: string }[],
  models?: readonly { providerID: string; id: string; name: string; variants?: readonly unknown[] }[],
) {
  const provider = providers?.find((item) => item.id === value.providerID)
  const info = models?.find((item) => item.providerID === value.providerID && item.id === value.modelID)
  return {
    provider: provider?.name ?? value.providerID,
    model: info?.name ?? `${value.modelID} (unavailable)`,
    reasoning: (info?.variants?.length ?? 0) !== 0,
  }
}

export function formatRef(model: { providerID: string; id: string; variant?: string }) {
  return [model.providerID, model.id, model.variant].filter((value) => value !== undefined).join("/")
}

export function switchLabel(
  model: { providerID: string; id: string; variant?: string },
  models?: readonly { providerID: string; id: string; name: string }[],
  previous?: { providerID: string; id: string; variant?: string },
) {
  if (previous?.providerID === model.providerID && previous.id === model.id)
    return `Switched variant to ${model.variant ?? "default"}`
  const display = models?.find((item) => item.providerID === model.providerID && item.id === model.id)?.name
  if (display === undefined) return `Switched model to ${formatRef(model)}`
  const variant = model.variant && model.variant !== "default" ? ` (${model.variant})` : ""
  return `Switched model to ${display}${variant}`
}
