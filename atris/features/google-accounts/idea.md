# google accounts in the command line

People can connect several google accounts and choose which account serves mail, calendar, and drive. One sign-in requests the products they select. The account list shows connected products, saved defaults, and the current business account.

`atris google use` saves a personal default on the server and keeps a local copy. A business has one account for all products, so its selection uses the business route. `atris google disconnect` requires confirmation and can remove selected products. Existing mail commands remain available.

Calendar reads without an account include events from every account, ordered by time and labeled when several accounts appear. Search results and the local cache carry account errors so a partial day is visible. Calendar writes can name an account. Scoped calendar commands stop when an older server cannot honor the choice. Calls made in a business folder, or with `--business`, carry that business to the server.

Mail follows the server default when no account is named. An older local mail choice moves to the server once if there is no saved default and the account still has mail. An obsolete local choice does not block the account list. Older servers keep the existing mail behavior.

Sign-in checks its own status and reports connected and missing products. If the status route is unavailable, it watches for an account change instead. A personal mail sign-in in a business folder does not assign that account to the business.
