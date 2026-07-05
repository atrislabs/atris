add input validation to the divide cli.

when the divisor is zero, exit with code 2 and print exactly this message to stderr:

divisor must be non-zero

keep successful division working on stdout.
