import { recipePrompt } from "../../support/recipes.js";
import { pollRecipe } from "../../support/rooms.js";
import { walkGuide } from "../../support/walk.js";

const GUIDE = "everyday/hobbies-and-games/game-night";

walkGuide(GUIDE, pollRecipe(GUIDE, `@<your bot> ${recipePrompt("people.game-night", {})}`));
