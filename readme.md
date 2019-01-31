# vscode-healthier

VSCode Extension integrating [Healthier Linter](https://github.com/KidkArolis/healthier).

## Usage

Install [Healthier](https://github.com/KidkArolis/healthier) in your workspace folder.

```
$ npm install --save-dev healthier
```

In Visual Studio Code, press <kbd>Cmd+Shift+P</kbd> and narrow down the list of commands by typing `extension`. Pick `Extensions: Install Extension`.

Search for the `healthier` extension in the list and install it.

**Note**: The extension will only lint your code using your locally installed Healthier package. This means you can keep the extension always enabled and it won't interfere in projects where Healthier is not used.

## Settings

This extension contributes the following variables to the settings.

- `healthier.enable`: enable/disable Healthier. It is enabled by default.
- `healthier.provideLintTask`: whether the extension contributes a lint task to lint a whole workspace folder.
- `healthier.run` - run the linter `onSave` or `onType`, default is `onType`.
- `healthier.runtime` - use this setting to set the path of the node runtime to run ESLint under.
- `healthier.validate` - an array of language identifiers specify the files to be validated. Something like `"healthier.validate": [ "javascript", "javascriptreact", "html" ]`. Defaults to `["javascript", "javascriptreact"]`.

## Commands:

This extension contributes the following commands to the Command palette.

- `Disable Healthier for this Workspace`: disables Healthier extension for this workspace.
- `Enable Healthier for this Workspace`: enable Healthier extension for this workspace.

## Development

- run npm install
- open VS Code
- Run the `watch` task to compile the client and server
- To run/debug the extension use the `Launch Extension` launch configuration
- to debug the server use the `Attach to Server` launch configuration
