import type { Option } from "effect";

/** An X account, by the ID X keys it on and its current handle. */
export interface Account {
  readonly id: string;
  readonly handle: string;
}

/** One page of accounts and the cursor for the page after it. */
export interface AccountsPage {
  readonly accounts: readonly Account[];
  readonly next: Option.Option<string>;
}
