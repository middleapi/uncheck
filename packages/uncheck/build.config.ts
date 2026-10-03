import { defineBuildConfig } from 'obuild/config'

export default defineBuildConfig({
  entries: [
    {
      type: 'bundle',
      input: ['./src/bin.ts', './src/presets/oxfmt.ts', './src/presets/oxlint.ts'],
      minifyLibs: true,
      dts: { sourcemap: false },
    },
  ],
})
