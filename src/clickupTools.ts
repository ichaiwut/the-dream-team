/**
 * Every write/mutating tool exposed by the ClickUp MCP connector, as of
 * when this list was written (checked against the tool set visible in a
 * live session — see note below). This is passed to `claude` as
 * `--disallowedTools` when spawning PM, so PM can use the SAME already-
 * authenticated ClickUp connector you use day to day to *read* a task,
 * without being able to write back to ClickUp — enforced by Claude Code's
 * own permission system, not by withholding a credential.
 *
 * IMPORTANT — this is a blocklist, which means it only blocks tools that
 * existed when this list was written. If the ClickUp MCP server adds a
 * new write-capable tool later, it will NOT be in this list and will NOT
 * be blocked until someone updates it here. Re-check this list against
 * your connector's current tool set periodically (ask Claude Code "what
 * ClickUp tools do you have?" or check your MCP server's docs) — do not
 * assume it stays complete forever. This is a materially weaker guarantee
 * than the old token-stripping approach, which blocked writes
 * structurally regardless of what tools existed.
 */
export const CLICKUP_WRITE_TOOLS: string[] = [
  "mcp__ClickUp__clickup_add_tag_to_task",
  "mcp__ClickUp__clickup_add_task_dependency",
  "mcp__ClickUp__clickup_add_task_link",
  "mcp__ClickUp__clickup_add_task_to_list",
  "mcp__ClickUp__clickup_add_time_entry",
  "mcp__ClickUp__clickup_attach_task_file",
  "mcp__ClickUp__clickup_create_comment",
  "mcp__ClickUp__clickup_create_document",
  "mcp__ClickUp__clickup_create_document_page",
  "mcp__ClickUp__clickup_create_folder",
  "mcp__ClickUp__clickup_create_list",
  "mcp__ClickUp__clickup_create_list_in_folder",
  "mcp__ClickUp__clickup_create_reminder",
  "mcp__ClickUp__clickup_create_space_tag",
  "mcp__ClickUp__clickup_create_task",
  "mcp__ClickUp__clickup_create_task_comment",
  "mcp__ClickUp__clickup_delete_chat_message",
  "mcp__ClickUp__clickup_delete_comment",
  "mcp__ClickUp__clickup_delete_task",
  "mcp__ClickUp__clickup_execute_operator",
  "mcp__ClickUp__clickup_merge_tasks",
  "mcp__ClickUp__clickup_move_task",
  "mcp__ClickUp__clickup_react_to_chat_message",
  "mcp__ClickUp__clickup_remove_tag_from_task",
  "mcp__ClickUp__clickup_remove_task_dependency",
  "mcp__ClickUp__clickup_remove_task_from_list",
  "mcp__ClickUp__clickup_remove_task_link",
  "mcp__ClickUp__clickup_request_attachment_upload",
  "mcp__ClickUp__clickup_send_chat_message",
  "mcp__ClickUp__clickup_start_time_tracking",
  "mcp__ClickUp__clickup_stop_time_tracking",
  "mcp__ClickUp__clickup_update_chat_message",
  "mcp__ClickUp__clickup_update_comment",
  "mcp__ClickUp__clickup_update_document_page",
  "mcp__ClickUp__clickup_update_folder",
  "mcp__ClickUp__clickup_update_list",
  "mcp__ClickUp__clickup_update_reminder",
  "mcp__ClickUp__clickup_update_task",
];
