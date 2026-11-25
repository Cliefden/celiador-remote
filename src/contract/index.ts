/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Celiador. Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

// The daemon's wire types, from its OpenAPI spec (Cliefden/celiador
// packages/client). schema.ts is vendored by scripts/sync-contract.mjs and
// never edited by hand; SOURCE names the celiador commit it came from.
// Types only: nothing here reaches the bundle.

import type { components } from './schema';

type Schemas = components['schemas'];

/** The relay's session states (`state` events). */
export type SessionState = Schemas['SessionState'];
/** What a runner publishes on `POST /api/sessions/{id}/events`. */
export type RunnerEvent = Schemas['RunnerEvent'];
/** A runner's reply to an `fs.*` / `git.*` command, posted on the event channel. */
export type FsResultFrame = Schemas['FsResultFrame'];
/** A command on `GET /api/sessions/{id}/commands`. Runners ignore kinds they don't know. */
export type SessionCommand = Schemas['SessionCommand'];
/** A command on the editor control stream `GET /api/presence/commands`. */
export type EditorCommand = Schemas['EditorCommand'];
export type EditorRunRequest = Schemas['EditorRunRequest'];
export type EditorTaskRequest = Schemas['EditorTaskRequest'];
/** One open repository in the presence heartbeat (`PUT /api/presence/workspaces`). */
export type WorkspaceEntry = Schemas['WorkspaceEntry'];
/** The body of `POST /api/tasks/{id}/status`. */
export type TaskStatusReport = Schemas['TaskStatusReport'];
