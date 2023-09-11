function editUrl(originalURL) {
    // Split the URL by '/'
    const parts = originalURL.split('/');
    // Remove the last part (the filename)
    parts.pop();
    // Reconstruct the URL
    return parts.join('/');
}

 
const homeButton = document.getElementById("home-button");

homeButton.addEventListener("click", function() {
    window.location.href = "/";
});

// Get the container div for the grid
const buttonGrid = document.querySelector('.questions-grid');

// Define the number of buttons and their labels

const completedQ = [
    '1', '2', '3', '4', '5', '6', '7', '8', '9', 
    '10', '11', '12', '13', '14', '15', '16', '17', '18', '19', 
    '20', '21', '22', '23', '24', '25', '26', '27', '28', '29', 
    '30', '31', '32', '33', '34', '35', '36', '37', '38', '39', 
    '40', '41', '42', '43', '44', '45', '46', '47', '48', '49', 
    '50', '51', '52', '53', '55', '56', '57', '58', 
    '60', '61', '62', '63', '66', '67', 
    '70', '71', '72', '73', '74', '75', '76', '77', '78', 
    '81', '82', '86', '87', '88', 
    '91', '93', '94', '95']



// make data
const buttonLabels = []
const gitUrlT = 'https://github.com/cheesepicklematt/project_euler_solutions/blob/main/q00'
for (const str of completedQ) {
    tmpQ = 'Question: '+str
    tmpUrl = str.length == 2 ? gitUrlT.slice(0, -1)+str+'/q'+str+'.py' : gitUrlT+str+'/q'+str+'.py';
    tmpEuler = 'https://projecteuler.net/problem='+str
    tmp = {
        'rowName':'<b>'+tmpQ+'</b>',
        'rowVal':'solution: q'+str+'.py',
        'url':tmpUrl,
        'eulerURL':tmpEuler
    }
    buttonLabels.push(tmp)
  }



// Loop through the button labels and create buttons
buttonLabels.forEach(label => {
    const quesButton_n = document.createElement('button');
    quesButton_n.className = 'question';
    quesButton_n.innerHTML = label.rowName;

    const quesButton_v = document.createElement('button');
    quesButton_v.className = 'question';
    quesButton_v.textContent = label.rowVal;

    // Add a click event listener to each button to open the link in a new tab
    quesButton_v.addEventListener('click', () => {
        window.open(label.url, '_blank');
    });
    
    quesButton_n.addEventListener('click', () => {
        window.open(label.eulerURL, '_blank');
    });
    

    // Append the button to the grid container
    buttonGrid.appendChild(quesButton_n);
    buttonGrid.appendChild(quesButton_v);
});

