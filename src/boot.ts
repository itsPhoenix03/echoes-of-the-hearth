import { initMenu } from "./menu";

initMenu(({ name, room }) => {
  localStorage.setItem("hearth-name", name);
  if (room) localStorage.setItem("hearth-room", room);
  import("./main").then((m) => m.startGame());
});
