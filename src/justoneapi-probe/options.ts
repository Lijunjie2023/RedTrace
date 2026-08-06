export interface ProbeOptions { keyword: string; noteLimit: number; commentPages: number; replyLimit: number }

function value(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function limitedInteger(raw: string | undefined, fallback: number, maximum: number, code: string): number {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(code);
  const parsed = Number(raw);
  if (parsed < 1 || parsed > maximum) throw new Error(code);
  return parsed;
}

export function parseProbeOptions(args: string[]): ProbeOptions {
  const keyword = value(args, "--keyword")?.trim() || "Leader";
  if (keyword.length > 50) throw new Error("keyword_invalid");
  return {
    keyword,
    noteLimit: limitedInteger(value(args, "--note-limit"), 3, 3, "note_limit_invalid"),
    commentPages: limitedInteger(value(args, "--comment-pages"), 1, 1, "comment_pages_invalid"),
    replyLimit: limitedInteger(value(args, "--reply-limit"), 3, 5, "reply_limit_invalid")
  };
}
