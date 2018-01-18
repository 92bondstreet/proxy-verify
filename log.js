const chalk = require('chalk');

module.exports = (args, runtime = '') => {
  let msg = '';
  let skipNext = false;

  for (let i = 0; i < args.length; i++) {
    const arg = typeof args[i] === 'object' ? JSON.stringify(args[i]) : String(args[i]);
    const next = typeof args[i] === 'object' ? JSON.stringify(args[i + 1]) : String(args[i + 1]);

    if (skipNext) {
      skipNext = false;
      continue;
    }

    if (arg && arg.substr(0, 2) === 'c:') {
      let color = arg.substr(2, arg.length);

      color = color.split(' ');
      if (color.length === 1) {
        msg += chalk[color[0]](next);
      } else if (color.length === 2) {
        msg += chalk[color[0]][color[1]](next);
      } else if (color.length === 3) {
        msg += chalk[color[0]][color[1]][color[2]](next);
      }
      skipNext = true;
    } else {
      msg += arg;
      skipNext = false;
    }
  }

  const str = runtime + chalk.grey('> ');
  const noAnsi = str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
  const padding = Array(12).join(' ');
  const maxLength = 12;

  console.log(`${str}${padding.substring(0, maxLength - noAnsi.length)}${msg}`);
};
