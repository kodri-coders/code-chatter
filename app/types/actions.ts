export type ActionType = 'file' | 'patch' | 'shell' | 'system_prompt_set';

export interface BaseAction {
  content: string;
}

export interface FileAction extends BaseAction {
  type: 'file' | 'patch';
  filePath: string;
}

export interface ShellAction extends BaseAction {
  type: 'shell';
}

export type BoltAction = FileAction | ShellAction;

export type BoltActionData = BoltAction | BaseAction;
