/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Celiador. Licensed under the Apache License, Version 2.0.
 *  Ported from the celiador-ai extension of the Celiador editor.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';

export function getRestrictedSetting<T>(key: string, defaultValue: T): T {
  const cfg = vscode.workspace.getConfiguration('celiador');
  const inspection = cfg.inspect<T>(key);
  if (!inspection) {return defaultValue;}
  return inspection.globalValue ?? inspection.defaultValue ?? defaultValue;
}
