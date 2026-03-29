/**
 * Shared application-level token constants.
 *
 * Centralises string literals that must stay consistent across multiple use
 * cases and the infrastructure routing layer.  Import from here instead of
 * redeclaring locally.
 */

/** Sentinel stored as guild_id for DM messages, which have no guild. */
export const DM_GUILD_TOKEN = "@me";

/** Custom ID for the Retry button attached to failed bot responses. */
export const RETRY_BUTTON_ID = "retry_mention";

/** Custom ID for the Next Page button attached to paginated bot responses. */
export const NEXT_PAGE_BUTTON_ID = "next_page";

/** Custom ID for the Render button attached to responses containing extended markdown. */
export const RENDER_BUTTON_ID = "render_image";

/** Custom ID for the Sources button attached to responses with grounding citations. */
export const SOURCES_BUTTON_ID = "show_sources";

/** Name of the Summarize message context menu command. */
export const SUMMARIZE_COMMAND_NAME = "Summarize";

/** Name of the Export as HTML message context menu command. */
export const EXPORT_HTML_COMMAND_NAME = "Export as HTML";

/** Name of the Export as Image message context menu command. */
export const EXPORT_IMAGE_COMMAND_NAME = "Export as Image";
