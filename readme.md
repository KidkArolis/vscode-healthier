# vscode-healthier

VSCode Extension integrating [Healthier Linter](https://github.com/KidkArolis/healthier).

## Usage

Install [Healthier](https://github.com/KidkArolis/healthier) in your workspace folder.

```
$ npm install --save-dev healthier
```

In Visual Studio Code, press <kbd>Cmd+Shift+P</kbd> and narrow down the list of commands by typing `extension`. Pick `Extensions: Install Extension`.

Search for the `healthier` extension from the list and install it.

## Format code using Prettier

Press `Cmd+Shift+P` and choose `Healthier: Format code using Prettier`

While this setting is available, the recommended approach is to keep it turned off and use the Prettier extension for formatting your code.

## Settings

Enable the linter in the VS Code Settings.

```json
{
	"healthier.enable": true
}
```

You can enable the formatter integration to use `healthier --fix` as formatter. Requires `healthier.enable` to be true. It is disabled by default.

```json
{
	"healthier.enable": true,
	"healthier.format.enable": true
}
```
