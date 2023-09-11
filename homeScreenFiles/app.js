



// An array of button names and their corresponding URLs
var buttonsWithLinks = [
    { name: "Memory Game", url: "memoryGame/memoryGame.html", colour:"#7CE8A9" },
    { name: "Pam's Birthday Party", url: "pamsBirthdayParty/dressP.html", colour:"#7C85E8" },
    { name: "Project Euler", url: "projectEuler/projectEuler.html", colour:"#E87CBB" }
];

// #E87CBB  c

document.addEventListener("DOMContentLoaded", function() {

    // Get a reference to the container div
    var container = document.getElementById("container");

    // Create and append buttons with links based on the array
    for (var i = 0; i < buttonsWithLinks.length; i++) {
        var buttonData = buttonsWithLinks[i];

        var button = document.createElement("button");
        button.textContent = buttonData.name;
        button.setAttribute("class", "projectButton");


        // Create a closure to capture the current buttonData
        (function(data) {
            var button = document.createElement("button");
            button.textContent = data.name;
            button.setAttribute("class", "projectButton");
            button.style.backgroundColor = data.colour;

            // Set an onclick event to navigate to the specified URL
            button.onclick = function() {
                window.location.href = data.url;
            };

            container.appendChild(button);
        })(buttonData); // Pass the current buttonData to the closure
    }
});