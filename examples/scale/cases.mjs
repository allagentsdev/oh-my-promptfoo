export default Array.from({ length: 1000 }, (_, row) => ({
  vars: { task: `Write row-${row} to result.txt in your working directory.` },
  assert: [
    {
      type: "javascript",
      value: `\nreturn import('node:fs').then(fs=>fs.readFileSync(context.providerResponse.metadata.workspace.path+'/result.txt','utf8').includes('row-${row}'));`,
    },
  ],
}));
