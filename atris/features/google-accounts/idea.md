# google accounts in the command line

People can connect several google accounts and choose which account serves mail, calendar, and drive. One sign-in requests the products they select. The account list shows connected products, saved defaults, and the current business account.

`atris google use` saves a personal default on the server and keeps a local copy. A business has one account for all products, so its selection uses the business route. `atris google disconnect` requires confirmation and can remove selected products. Existing mail commands remain available.

Calendar reads without an account include events from every account, ordered by time and labeled when several accounts appear. Calendar writes can name an account. Calls made in a business folder, or with `--business`, carry that business to the server.

An older server keeps the mail-only commands available and reports that calendar and drive accounts need a newer server. The sign-in check waits for the account list to change, because the server does not provide a command-line completion signal.
