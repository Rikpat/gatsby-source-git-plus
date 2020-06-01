# gatsby-source-git-plus

A Gatsby source plugin that clones a specified repository and then uses gatsby-source-filesystem to create file nodes for the repository.

It uses nodegit internally and generates `GitRemote` and `GitCommit` nodes with information about remotes and commits

This repository was inspired by [gatsby-source-git](https://github.com/stevetweeddale/gatsby-source-git), but it doesn't use shallow clone, to store all commits, to make it possible to query for users that modified files.

### Dependencies

This plugin uses gatsby-source-filesystem as peer dependency, please install using

```
 npm install --save gatsby-source-filesystem
```

## How to install

Install plugin from npm

```
 npm install --save gatsby-source-git-plus
```

## Available options

- **name**: name of the source instance (gets stored in sourceInstanceName property on file)
- **remote**: remote url. In case of using credentials, use `https://[username]:[password]@[remoteurl]/`
- **branch**: not working currently
- **Any options for gatsby-plugin-filesystem**

## When do I use this plugin?

Separating content from engine, having markdown files in a different repository than the gatsby code, or using multiple repositories for documentation purposes

## Examples of usage

```js
// In your gatsby-config.js
module.exports = {
  plugins: [
    // You can have multiple instances of this plugin
    // to read source nodes from different repositories.
    {
      resolve: `gatsby-source-git`,
      options: {
        name: `gatsby-docs`,
        remote: `https://github.com/gatsbyjs/gatsby.git`,
        // Tailor which files get imported eg. import the docs folder from a codebase.
        patterns: `docs/**/*`
      }
    },
    {
      resolve: `gatsby-source-git`,
      options: {
        name: `PAT-example`,
        remote: `https://PAT:${PAT}@dev.azure.com/${pathToRepository}`,
        patterns: `**/*`
      }
    }
  ]
};
```

## How to query for data

This plugin generates file nodes using gatsby-source-filesystem, so querying of files is the same, with two added nodes, GitRemote, and array of GitCommits.

The plugin loads reads all commits and creates nodes, then links the files to commits that modified them.

The GitCommit node contains an author object with name and email, commit date, commit message and gitRemote.

For example if you wanted to get all authors, and dates, to show the last edit and all editors of a file, you could just query

```graphQL
file {
    gitCommit {
        author {
            email
        }
        date(formatString: "M/D/YYYY")
    }
}
```

and to show the latest commit use `file.gitCommit[0]`.

## How to run tests

Not implemented yet

## How to develop locally

## How to contribute

Please make a PR, I don't have much time to work on this right now, but I would appreciate all help.

## Todo

- [ ] Unit testing
- [ ] Caching
- [ ] Cloning a single branch/specifying branch
- [ ] Typescript (probably, the gatsby-node gets confusing really fast)
- [ ] Remove duplicate code that exists in gatsby-source-filesystem and just create folders and call sourceInstanceNodes on gatsby-source-filesystem
- [ ] Create queries for unique authors ordered by number of commits, and other useful queries
