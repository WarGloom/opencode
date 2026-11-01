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
  models?: readonly {
    providerID: string
    id: string
    name: string
    experimental?: { speed?: { base: string; id: string } }
  }[],
  previous?: { providerID: string; id: string; variant?: string },
) {
  if (previous?.providerID === model.providerID && previous.id === model.id)
    return `Switched variant to ${model.variant ?? "default"}`
  const find = (ref: { providerID: string; id: string }) =>
    models?.find((item) => item.providerID === ref.providerID && item.id === ref.id)
  const info = find(model)
  if (info === undefined) return `Switched model to ${formatRef(model)}`
  // A model's faster and slower speeds are models of their own ("gpt-5.5-fast"), so moving between them is a
  // change of speed.
  const before = previous?.providerID === model.providerID ? find(previous) : undefined
  if (before && (before.experimental?.speed?.base ?? before.id) === (info.experimental?.speed?.base ?? info.id))
    return `Switched speed to ${info.experimental?.speed?.id ?? "standard"}`
  const variant = model.variant && model.variant !== "default" ? ` (${model.variant})` : ""
  return `Switched model to ${info.name}${variant}`
}
