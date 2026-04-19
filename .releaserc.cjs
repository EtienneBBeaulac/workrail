const allowMajorRelease = process.env.WORKRAIL_ALLOW_MAJOR_RELEASE === "true";
const breakingReleaseType = allowMajorRelease ? "major" : "minor";

// Every merge to main publishes to @beta (e.g. 3.41.0-beta.1).
// To promote to @latest, use the "Promote to latest" workflow in GitHub Actions --
// it runs `npm dist-tag add @exaudeus/workrail@<beta-version> latest` without
// creating a new version. The tested beta artifact becomes the stable release.

module.exports = {
  branches: [
    // Stable channel: the 'release' branch publishes clean versions (e.g. 3.41.0) to @latest.
    // This branch is currently unused -- promotion is done via `npm dist-tag add` in
    // the "Promote to latest" GitHub Actions workflow instead.
    // Defined here because semantic-release requires at least one non-prerelease branch.
    "release",
    // Auto-releases on every merge to main: published as @beta (e.g. 3.41.0-beta.1)
    { name: "main", channel: "beta", prerelease: "beta" },
  ],
  tagFormat: "v${version}",
  repositoryUrl: `https://x-access-token:${process.env.GITHUB_TOKEN}@github.com/EtienneBBeaulac/workrail.git`,
  plugins: [
    [
      "@semantic-release/commit-analyzer",
      {
        preset: "conventionalcommits",
        releaseRules: [
          { type: "feat", release: "minor" },
          { type: "fix", release: "patch" },
          { type: "perf", release: "patch" },
          { type: "revert", release: "patch" },
          { type: "docs", release: false },
          { type: "style", release: false },
          { type: "chore", release: false },
          { type: "refactor", release: false },
          { type: "test", release: false },
          { type: "build", release: false },
          { type: "ci", release: false },
          { breaking: true, release: breakingReleaseType }
        ]
      }
    ],
    [
      "@semantic-release/release-notes-generator",
      {
        preset: "conventionalcommits",
        presetConfig: {
          types: [
            { type: "feat", section: "Features" },
            { type: "fix", section: "Bug Fixes" },
            { type: "perf", section: "Performance Improvements" },
            { type: "revert", section: "Reverts" },
            { type: "docs", section: "Documentation", hidden: true },
            { type: "style", section: "Styles", hidden: true },
            { type: "chore", section: "Miscellaneous Chores", hidden: true },
            { type: "refactor", section: "Code Refactoring", hidden: true },
            { type: "test", section: "Tests", hidden: true },
            { type: "build", section: "Build System", hidden: true },
            { type: "ci", section: "Continuous Integration", hidden: true }
          ]
        }
      }
    ],
    [
      "@semantic-release/exec",
      {
        prepareCmd: "npm pkg set version=${nextRelease.version}",
        publishCmd: "npm publish --access public --tag beta"
      }
    ],
    "@semantic-release/github"
  ]
};
