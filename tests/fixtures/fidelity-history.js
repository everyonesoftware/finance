// Synthetic Fidelity-format history; no customer records.
export const fidelityHeader = 'Run Date,Action,Symbol,Description,Type,Price ($),Quantity,Commission ($),Fees ($),Accrued Interest ($),Amount ($),Cash Balance ($),Settlement Date';
export const fidelityRows = [
  '10/30/2026,REINVESTMENT EXAMPLE FUND (DEMO) (Cash),DEMO,EXAMPLE FUND,Cash,10,2.5,,,,"-25",0.01,',
  '10/30/2026,DIVIDEND RECEIVED EXAMPLE FUND (DEMO) (Cash),DEMO,EXAMPLE FUND,Cash,,0,,,,25,25.01,',
  '10/30/2026,INTEREST EARNED CASH (Cash),FCASH,CASH,Cash,,0,,,,0.01,0.01,',
  '10/27/2026,Electronic Funds Transfer Paid (Cash),,No Description,Cash,,0,,,,"-100",0,',
  '10/27/2026,Electronic Funds Transfer Paid (Cash),,No Description,Cash,,0,,,,"-100",100,',
  '10/26/2026,YOU SOLD EXAMPLE FUND (DEMO) (Cash),DEMO,EXAMPLE FUND,Cash,10,-20,,,,200,200,10/27/2026',
  '10/20/2026,YOU BOUGHT EXAMPLE FUND (DEMO) (Cash),DEMO,EXAMPLE FUND,Cash,10,3,,,,"-30",0,10/21/2026',
  '10/20/2026,Electronic Funds Transfer Received (Cash),,No Description,Cash,,0,,,,30,30,',
];
export const fidelityFooter = '\n\nThe data and information in this spreadsheet is provided to you solely for your use and is not for distribution. The spreadsheet is provided for\n"informational purposes only, and is not intended to provide advice, nor should it be construed as an offer to sell, a solicitation of an offer to buy or a"\nrecommendation for any security or insurance product by Fidelity or any third party.\n\n"Brokerage services are provided by Fidelity Brokerage Services LLC (FBS), 900 Salem Street, Smithfield, RI 02917."\n\nDate downloaded 11/10/2026 05:16 pm\n';
export const fidelityHistory = '\uFEFF\n\n' + fidelityHeader + '\n' + fidelityRows.join('\n') + fidelityFooter;
