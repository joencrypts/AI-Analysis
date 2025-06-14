import React from 'react';
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';

interface PDFGeneratorProps {
  children: React.ReactNode;
  reportRef: React.RefObject<HTMLDivElement>;
  reportData: {
    repair_description: string;
    cost_estimation: {
      total: string;
      breakdown: {
        materials: string;
        labor: string;
        permits: string;
        safety_equipment: string;
      };
    };
    timeline: {
      estimated_duration: string;
      phases: string[];
    };
  };
}

function PDFGenerator({ children, reportRef, reportData }: PDFGeneratorProps) {
  const generatePDF = async () => {
    if (!reportRef.current) return;

    try {
      // Create a temporary container for PDF generation
      const tempContainer = document.createElement('div');
      tempContainer.style.width = '210mm'; // A4 width
      tempContainer.style.padding = '20mm';
      tempContainer.style.backgroundColor = '#ffffff';
      tempContainer.style.position = 'absolute';
      tempContainer.style.left = '-9999px';
      tempContainer.style.top = '0';
      document.body.appendChild(tempContainer);

      // Clone the report content
      const reportContent = reportRef.current.cloneNode(true) as HTMLElement;
      tempContainer.appendChild(reportContent);

      // Add additional PDF-specific styling
      const style = document.createElement('style');
      style.textContent = `
        .pdf-content {
          font-family: Arial, sans-serif;
          color: #000000;
        }
        .pdf-header {
          text-align: center;
          margin-bottom: 20px;
          border-bottom: 2px solid #2563eb;
          padding-bottom: 10px;
        }
        .pdf-section {
          margin: 15px 0;
          padding: 10px;
          border: 1px solid #e5e7eb;
          border-radius: 4px;
        }
        .pdf-section h3 {
          color: #2563eb;
          margin-bottom: 10px;
        }
        .pdf-cost-breakdown {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 10px;
          margin: 10px 0;
        }
        .pdf-timeline {
          margin: 15px 0;
        }
        .pdf-timeline-phase {
          margin: 5px 0;
          padding-left: 20px;
          position: relative;
        }
        .pdf-timeline-phase:before {
          content: "•";
          position: absolute;
          left: 0;
          color: #2563eb;
        }
        .pdf-footer {
          margin-top: 20px;
          text-align: center;
          font-size: 12px;
          color: #6b7280;
          border-top: 1px solid #e5e7eb;
          padding-top: 10px;
        }
      `;
      tempContainer.appendChild(style);

      // Configure html2canvas options for better quality
      const canvas = await html2canvas(tempContainer, {
        scale: 2,
        useCORS: true,
        allowTaint: true,
        backgroundColor: '#ffffff',
        logging: false,
        windowWidth: 210 * 8, // A4 width in pixels at 96 DPI
        windowHeight: tempContainer.scrollHeight,
      });

      // Clean up temporary container
      document.body.removeChild(tempContainer);

      const imgData = canvas.toDataURL('image/png');
      
      // Create PDF
      const pdf = new jsPDF({
        orientation: 'portrait',
        unit: 'mm',
        format: 'a4',
      });

      // Calculate dimensions to fit the page
      const pdfWidth = pdf.internal.pageSize.getWidth();
      const pdfHeight = pdf.internal.pageSize.getHeight();
      const imgWidth = canvas.width;
      const imgHeight = canvas.height;
      
      // Calculate scale to fit width
      const scale = pdfWidth / imgWidth;
      const scaledHeight = imgHeight * scale;
      
      // Add the image to PDF
      if (scaledHeight <= pdfHeight) {
        // Fits on one page
        pdf.addImage(imgData, 'PNG', 0, 0, pdfWidth, scaledHeight);
      } else {
        // Split across multiple pages
        let position = 0;
        const pageHeight = pdfHeight;
        
        while (position < scaledHeight) {
          const remainingHeight = scaledHeight - position;
          const heightToAdd = Math.min(pageHeight, remainingHeight);
          
          if (position > 0) {
            pdf.addPage();
          }
          
          pdf.addImage(
            imgData,
            'PNG',
            0,
            -position,
            pdfWidth,
            scaledHeight
          );
          
          position += heightToAdd;
        }
      }

      // Add page numbers
      const pageCount = pdf.getNumberOfPages();
      for (let i = 1; i <= pageCount; i++) {
        pdf.setPage(i);
        pdf.setFontSize(10);
        pdf.setTextColor(100);
        pdf.text(
          `Page ${i} of ${pageCount}`,
          pdfWidth - 20,
          pdfHeight - 10
        );
      }

      // Save the PDF
      const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
      pdf.save(`Infrastructure-Completion-Report-${timestamp}.pdf`);
    } catch (error) {
      console.error('Error generating PDF:', error);
      alert('Error generating PDF. Please try again.');
    }
  };

  return (
    <div onClick={generatePDF} className="cursor-pointer hover:opacity-90 transition-opacity pdf-generator">
      {children}
    </div>
  );
}

export default PDFGenerator;