import { recipePrompt } from "../../support/recipes.js";
import { pollRecipe } from "../../support/rooms.js";
import { walkGuide } from "../../support/walk.js";

const GUIDE = "everyday/home-family-and-pets/carpool";

walkGuide(
  GUIDE,
  pollRecipe(GUIDE, `@<your bot> ${recipePrompt("people.carpool", { activity: "Saturday football practice", weeks: "three weeks" })}`),
);
