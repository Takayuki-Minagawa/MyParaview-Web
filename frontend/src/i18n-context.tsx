import { createContext, useContext, type ReactNode } from "react";
import { MESSAGES, type Language, type Messages } from "./i18n";

const MessagesContext = createContext<Messages>(MESSAGES.ja);

export function MessagesProvider({
  language,
  children,
}: {
  language: Language;
  children: ReactNode;
}) {
  return (
    <MessagesContext.Provider value={MESSAGES[language]}>{children}</MessagesContext.Provider>
  );
}

export function useMessages(): Messages {
  return useContext(MessagesContext);
}
