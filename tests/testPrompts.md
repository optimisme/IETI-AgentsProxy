
> Create a new file named clock.html at webs folder that shows an analog circular watch updated every second and drawn on a canvas, make it look like a swiss trains watch, search on the internet the look of swiss train station clocks.

- modify @webs/clock.html in a way that continuously updates seconds hand at 30fps showing a smooth movement instead of jumping every second

- modify @webs/clock.html so it shows the seconds hand in green instead of blue

> Create a new file named snake.html at webs folder with a playable Snake game using only HTML, CSS, and JavaScript. Use canvas, keyboard arrows to control direction, the game doesn't start until user presses a direction key, the game has a score display, pause/restart buttons, and run the web checker.

- modify @webs/snake.html to ensure the food is drawn like a red circle, don't allow drawing the food like a square or a different color than red

> Create a new file named slider.html at webs folder with a slider puzle 3x3 that moves the clicked piece to the empty space, make the pieces with big numbers from 1 to 8 and making it solved when all numbers are properly sorted and the empty space is at bottom right corner. Don't use canvas, each piece must be a `<div>`. 

- modify @webs/slider.html pieces animate smoothly, don't make them jump from begin position to end one.


---

Create a new todo website at webs folder (todo.html, todo.css and todo.js) with a polished todo app using localStorage. Include add, edit, complete, delete, filters, clear completed, keyboard support, responsive layout. 

Create a new weather-card website at webs folder (weather.html, weather.css, weather.js) with a polished weather card UI. Search the web for the current weather in Barcelona, then build a static HTML page showing the city, temperature, condition, humidity, wind, and update time. Use only HTML, CSS, and JavaScript, cite the source visibly in the page

Create a new travel-guide website at webs folder (travel.html, travel.css, travel.js) with a mini travel guide for Girona. Search the web for 5 recommended places to visit, opening hours when available, short descriptions, and official links. Build a responsive card-based page with search/filter by category. Use only HTML, CSS, and JavaScript, cite sources

Create a new museum-guide website at webs folder (museum.html, museum.css, museum.js). Search the web for 5 museums in Barcelona, including official websites, opening hours when available, location, and short descriptions. Build a responsive card-based guide with category filters and visible citations. Use only HTML, CSS, and JavaScript


Create a new paint-like editor website at webs folder (paint.html, paint.css, paint.js). Build a canvas editor using only HTML, CSS, and JavaScript. Include color picker, eraser, line size, clear button. User must draw "free hand" when mouse is pressed and moved on the canvas, capturing movement points and joining those points with lines.

Look at image @./tests/calculator.png, it is a picture of a calculator, inspect its design, colors, buttons and screen distribution and brand location. Then create a new website at webs folder (calculator.html) and include basic operations, decimal numbers, keyboard support, clear/delete buttons, error handling for invalid operations. Make it look like the calculator in the picture, even the positioning of the buttons. Ensure the ON/OFF slider is on by default

Create a new website at webs folder (kanban.html, kanban.css, kanban.js) with a simple Kanban board using only HTML, CSS, and JavaScript. Include three columns: Todo, Doing, Done. Allow adding cards, editing text, deleting cards, dragging cards between columns, saving state with localStorage, responsive layout. Ensure cards can be moved from one status to another, for example from Todo to Doing, or from Doing back to Todo.

Create a new website at webs folder mines.html with a minesweeper like windows 95 game. search on the internet the mechanics and look and feel of the game, then reproduce it on a web. 

Create a new website in the webs folder named asteroid.html, asteroid.css, and asteroid.js. Build a polished 1980s arcade-style Asteroids-like canvas game with vector graphics. The game must start only after the first key press. Controls: ArrowLeft and ArrowRight rotate the ship, ArrowUp thrusts, Space shoots. Include screen wrapping, drifting asteroids that split into smaller asteroids, enemy saucers that occasionally appear and shoot, player lives, score, localStorage high score, pause with P, restart after game over with Enter, and a clear HUD. Use only canvas and plain JavaScript. Verify the files. This is a 2d plain game, don't make 3d calculations in it.

# Pagoda 3D

Act as an expert WebGL engineer specializing in Three.js and procedural generation.

Create a complete, playable 3D voxel island explorer as one self-contained index.html file.

Requirements:

- Load Three.js from a CDN. Do not use external textures, models, images or audio files.
- Procedurally generate a Minecraft-inspired island using Simplex/Perlin noise, a custom heightmap and radial island falloff.
- Include visually distinct grass, dirt, stone and sand blocks, plus an animated water surface.
- Use InstancedMesh or chunk-based rendering for good performance.
- Add a first-person camera with Pointer Lock controls: WASD movement, mouse look and Space to jump or swim.
- Use raycasting so left click breaks blocks and right click places the selected block.
- Implement gravity and reliable voxel collision detection.
- Add procedural Web Audio effects: footsteps based on terrain, block-breaking and placement sounds, and gentle ambient music.
- Include a crosshair, numbered hotbar, inventory counter and day/night toggle.
- Make the interface responsive and display the controls before starting.
- Test that grass and dirt remain distinguishable from every camera angle.

Return a working HTML+CSS+JS files code. Write empty files and then add code in small chunks, don't write big monolite code blocks.

create a tetris like game at webs/tetris.html file, ensure when a new line is done it blinks twice before disappearing

create a new webs/pagoda3.html demo with a japanese looking pagoda with 2d traditional japanese drawings, animated with cherry blossom trees and at least 5000 floating dandelions. use threejs to create the world with plain 2d look and feel