add a stats subcommand to the inventory cli.

keep the existing list subcommand working.

stats must read stock.json and print one json object to stdout with:
- items: number of distinct skus
- quantity: sum of all on-hand quantities

example shape: {"items":2,"quantity":8}
