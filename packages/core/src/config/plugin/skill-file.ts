export * as SkillFile from "./skill-file.js"

import type { SkillEditor } from "@opencode/plugin/effect/skill"
import path from "path"
import { isRecord } from "@opencode/util/record"
import { Result, Schema, type SchemaIssue, SchemaParser } from "effect"
import { ConfigMarkdown } from "../markdown.js"
import { AbsolutePath } from "../../schema.js"
import { Skill } from "../../skill.js"

const Frontmatter = Schema.Struct({
  name: Schema.String.pipe(Schema.optional),
  description: Schema.String.pipe(Schema.optional),
  metadata: Schema.Unknown.pipe(Schema.optional),
  "disable-model-invocation": Schema.Unknown.pipe(Schema.optional),
})
const decodeFrontmatter = SchemaParser.decodeUnknownResult(Frontmatter)

/** Roots are loaded in configuration order; the last root wins, then the last sorted path within that root. */
export function preferLater(skills: ReadonlyArray<Skill.Info>): Skill.Info[] {
  const paths = new Set<string>()
  const names = new Set<string>()
  const ids = new Set<string>()
  return skills
    .toReversed()
    .filter((skill) => {
      if (paths.has(skill.path) || names.has(skill.name) || ids.has(skill.id)) return false
      paths.add(skill.path)
      names.add(skill.name)
      ids.add(skill.id)
      return true
    })
    .reverse()
}

export function register(editor: Pick<SkillEditor, "list" | "remove" | "add">, skills: ReadonlyArray<Skill.Info>) {
  const existing = editor.list().filter((skill) => path.isAbsolute(skill.path))
  const paths = new Map(existing.map((skill) => [skill.path, skill.id]))
  const names = new Map(existing.map((skill) => [skill.name, skill.id]))
  for (const skill of skills) {
    for (const alias of [paths.get(skill.path), names.get(skill.name)]) {
      if (alias !== undefined && alias !== skill.id) editor.remove(alias)
    }
    editor.add(skill)
  }
}

export type ParseResult =
  | { readonly _tag: "Parsed"; readonly skill: Skill.Info }
  | { readonly _tag: "Skipped"; readonly reason: "markdown" }
  | { readonly _tag: "Skipped"; readonly reason: "frontmatter"; readonly issue: SchemaIssue.Issue }

const metadataBoolean = (metadata: unknown, key: string) => {
  if (!isRecord(metadata)) return undefined
  return booleanValue(metadata[key])
}

const booleanValue = (value: unknown) => {
  if (typeof value === "boolean") return value
  if (typeof value === "number") return value === 1 ? true : value === 0 ? false : undefined
  if (typeof value !== "string") return undefined
  const normalized = value.trim().toLowerCase()
  if (["true", "yes", "on", "1"].includes(normalized)) return true
  if (["false", "no", "off", "0"].includes(normalized)) return false
  return undefined
}

export function parse(directory: string, filepath: string, content: string): ParseResult {
  const markdown = ConfigMarkdown.parseOption(content)
  if (!markdown) return { _tag: "Skipped", reason: "markdown" }
  const decoded = decodeFrontmatter(markdown.data)
  if (Result.isFailure(decoded)) return { _tag: "Skipped", reason: "frontmatter", issue: decoded.failure }
  const frontmatter = decoded.success
  const id =
    path.dirname(filepath) === directory && path.basename(filepath) !== "SKILL.md"
      ? path.basename(filepath, ".md")
      : path.basename(path.dirname(filepath))
  const opencodeAutoinvoke = metadataBoolean(frontmatter.metadata, "opencode/autoinvoke")
  const disableModelInvocation = booleanValue(frontmatter["disable-model-invocation"])
  const autoinvoke = opencodeAutoinvoke ?? (disableModelInvocation ? false : undefined)
  return {
    _tag: "Parsed",
    skill: {
      id: Skill.ID.make(id),
      name: Skill.Name.make(frontmatter.name ?? id),
      ...(frontmatter.description === undefined ? {} : { description: frontmatter.description }),
      ...(autoinvoke === undefined ? {} : { autoinvoke }),
      path: AbsolutePath.make(filepath),
      content: markdown.content,
    },
  }
}
