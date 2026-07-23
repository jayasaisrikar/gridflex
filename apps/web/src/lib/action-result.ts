export type ActionResult = {
  status: 'idle' | 'success' | 'error';
  message: string;
  details: Record<string, string>;
  fieldErrors?: Record<string, string>;
};

export const INITIAL_ACTION_RESULT: ActionResult = {
  status: 'idle',
  message: '',
  details: {},
};
