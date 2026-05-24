import * as vscode from "vscode";

import { messages as enMessages } from "./i18n/en";
import { messages as zhCnMessages, type MessageKey } from "./i18n/zh-cn";

type MessageValues = Record<string, string | number | boolean | undefined>;

const messages = vscode.env.language.toLowerCase().startsWith("zh")
    ? zhCnMessages
    : enMessages;

export function t(key: MessageKey, values: MessageValues = {}): string {
    const message = messages[key];
    return message.replace(/\{(\w+)\}/g, (placeholder, name: string) => {
        const value = values[name];
        return value === undefined ? placeholder : String(value);
    });
}
