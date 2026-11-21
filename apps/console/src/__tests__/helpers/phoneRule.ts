/**
 * AS19's one phone rule (R6): the shared table both clients test, exactly (the agent app keeps
 * its own copy). Each row: the value as uploaded, its full form, its masked form.
 */
export const PHONE_RULE_TABLE: ReadonlyArray<readonly [string, string, string]> = [
  ['9876543210', '+91 98765 43210', '98••• ••210'],
  ['919876543210', '+91 98765 43210', '98••• ••210'],
  ['+919876543210', '+91 98765 43210', '98••• ••210'],
  ['09876543210', '+91 98765 43210', '98••• ••210'],
  ['1234567890', '1234567890', '12••• ••890'],
  ['+14155550123', '+14155550123', '14••• ••123'],
];
