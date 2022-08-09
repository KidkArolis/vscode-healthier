# vscode-healthier

VSCode Extension integrating [Healthier Linter](https://github.com/KidkArolis/healthier).

## Usage

Install [Healthier](https://github.com/KidkArolis/healthier) in your workspace folder.

```
$ npm install --save-dev healthier
```

In Visual Studio Code, press <kbd>Cmd+Shift+P</kbd> and narrow down the list of commands by typing `extension`. Pick `Extensions: Install Extension`.

Search for the `healthier` extension in the list and install it.

**Note**: The extension will only lint your code using your locally installed Healthier package by default. This means you can keep the extension always enabled and it won't interfere in projects where Healthier is not used.

## Settings

This extension contributes the following variables to the settings.

- `healthier.enable`: Enable or disable Healthier. It is enabled by default.
- `healthier.enableGlobally`: Controls whether Healthier is enabled globally for JavaScript files or not.
- `healthier.usePackageJson`: Activate Healthier based on project's package.json settings, use globally installed healthier module if set to `false`.
- `healthier.nodePath` - A path added to NODE_PATH when resolving the healthier module.
- `healthier.options` - The healthier options object to provide args normally passed to Healthier when executed from a command line.
- `healthier.engine` - Controls whether VSCode should use an alternate Healthier engine, like ts-healthier. (Note: To be implemented).
- `healthier.trace.server` - Traces the communication between VSCode and the Healthier linter service.
- `healthier.run` - run the linter `onSave` or `onType`, default is `onType`.
- `healthier.workingDirectories` - The working directory to use if a file's path start with this directory.
- `healthier.validate` - an array of language identifiers specify the files to be validated. Something like `"healthier.validate": [ "javascript", "javascriptreact", "html", "typescript" ]`. Defaults to `["javascript", "javascriptreact"]`.
- `healthier.treatErrorsAsWarnings` - Any linting error reported by Healthier will instead be displayed as a warning within VS Code.

**Note:** For TypeScript support, add `"typescript"` to the `healthier.validate` setting as shown above and see: [healthier#typescript](https://github.com/KidkArolis/healthier#typescript)

## Commands:

This extension contributes the following commands to the Command palette.

- `Disable Healthier for this Workspace`: disables Healthier extension for this workspace.
- `Enable Healthier for this Workspace`: enable Healthier extension for this workspace.
- `Show Output Channel`: show the output channel of the extension.

## Development

- run npm install
- open VS Code
- run the `watch` task to compile the client and server
- to run/debug the extension use the `Launch Extension` launch configuration
- to debug the server use the `Attach to Server` launch configuration
