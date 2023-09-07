


function getRandomNumber(max) {
    return Math.floor(Math.random() * max);
}

function getRandomWord() {
    return wordList[getRandomNumber(wordListLen)];
}



const imageUrls = [
    'https://images.unsplash.com/photo-1584661156681-540e80a161d3?ixlib=rb-4.0.3&ixid=M3wxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8fA%3D%3D&auto=format&fit=crop&w=1935&q=80',
    'https://images.unsplash.com/photo-1567613781592-dabff149cb90?ixlib=rb-4.0.3&ixid=M3wxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8fA%3D%3D&auto=format&fit=crop&w=2070&q=80',
    'https://plus.unsplash.com/premium_photo-1661746446654-ad66aa338843?ixlib=rb-4.0.3&ixid=M3wxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8fA%3D%3D&auto=format&fit=crop&w=2070&q=80'
    // Add more image URLs as needed
];
 
const wordList = [
    "Pirate", "Princess",
    "Pumpkin", "Police officer",
    "Pikachu (from Pokémon)", "Pilot",
    "Plumber", "Panda",
    "Peter Pan", "Puss in Boots",
    "Pinocchio", "Princess Leia (from Star Wars)",
    "Professor Dumbledore (from Harry Potter)", "Patrick Star (from SpongeBob SquarePants)",
    "Pocahontas", "Popeye",
    "Paul McCartney (musician)", "Pablo Picasso (artist)",
    "Princess Diana (royalty)", "Paul Newman (actor)",
    "Pierre Curie (physicist)", "Plácido Domingo (singer)",
    "Paul Walker (actor)", "Penélope Cruz (actress)",
    "Physician", "Paramedic",
    "Pharmacist", "Photographer",
    "Physicist", "Painter",
    "Plumber", "Personal trainer"
  ];
wordListLen = wordList.length
 

// get elements
const buttonContainer = document.getElementById("buttonContainer")
const imageElement = document.getElementById('imageElement');
const pWordsPara = document.getElementById("pWords")



// initialise some elements
genButton = document.createElement("button");
genButton.textContent = "Generate an idea"
buttonContainer.appendChild(genButton);
 
 
const homeButton = document.getElementById("home-button");

homeButton.addEventListener("click", function() {
    window.location.href = "/";
});
 
// Add an event listener to the button
genButton.addEventListener("click", function() {
    // Define the text you want to display
    const textToDisplay = getRandomWord();

    // display image

    
    imageUrl = imageUrls[getRandomNumber(imageUrls.length)]
    imageElement.src = imageUrl
    imageElement.style.display = 'block';

    // Update the content of the output paragraph with the text
    pWordsPara.textContent = textToDisplay;
});
