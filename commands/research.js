const { initResearchWorkspace } = require('./business');

async function researchQuickstart() {
  console.log(`
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Start a Research Lab in 3 Commands
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  1. Create:
     atris research init "Frontier Lab"

  2. Open the local workspace:
     cd ~/arena/atris-business/frontier-lab

  3. Push local state to cloud:
     atris align --fix

  The research template starts with:
     hypotheses + experiment lanes
     eval-first reward policy
     literature + findings workflow
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
}

async function researchCommand(subcommand, ...args) {
  switch (subcommand) {
    case 'init':
    case 'workspace':
    case 'create':
      await initResearchWorkspace(args[0], ...args.slice(1));
      break;
    case 'quickstart':
    case 'start':
    case 'guide':
      await researchQuickstart();
      break;
    default:
      console.log('Usage: atris research <command> [args]');
      console.log('');
      console.log('  quickstart           ← Start here! 3-command guide');
      console.log('');
      console.log('  init <name>          Create a research lab workspace (cloud + local)');
      console.log('  workspace <name>     Alias for init');
      console.log('  create <name>        Alias for init');
  }
}

module.exports = {
  researchCommand,
  researchQuickstart,
};
